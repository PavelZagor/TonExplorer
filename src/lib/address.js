'use strict';

// Minimal TON address parsing — no SDK dependency for the Phase 0 skeleton.
// We accept raw form `<workchain>:<64 hex>` and user-friendly `EQ.../UQ.../kQ.../0Q...` base64url(32B + tag + crc).
// We normalize to raw form for use as a stable DB key. Friendly→raw conversion uses base64url decoding + minimal validation.

const RAW_RE = /^-?\d+:[0-9a-fA-F]{64}$/;
const FRIENDLY_RE = /^[A-Za-z0-9_-]{48}$/;

function isRaw(addr) {
  return typeof addr === 'string' && RAW_RE.test(addr.trim());
}

function isFriendly(addr) {
  return typeof addr === 'string' && FRIENDLY_RE.test(addr.trim());
}

function base64UrlToBuffer(s) {
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : '';
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

// CRC16/XMODEM (poly 0x1021, init 0x0000) — used by TON friendly addresses.
function crc16(buf) {
  let crc = 0;
  for (const byte of buf) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc;
}

function parseFriendly(addr) {
  const buf = base64UrlToBuffer(addr);
  if (buf.length !== 36) {
    throw new Error('friendly address must decode to 36 bytes');
  }
  const tag = buf[0];
  const workchain = buf.readInt8(1);
  const hash = buf.subarray(2, 34);
  const checksum = buf.readUInt16BE(34);
  const expected = crc16(buf.subarray(0, 34));
  if (checksum !== expected) {
    throw new Error('friendly address CRC mismatch');
  }
  return {
    workchain,
    hash,
    bounceable: (tag & 0x40) !== 0 ? false : true, // 0x11/0x51 bounceable, 0x51/0x91 non-bounceable
    testnetOnly: (tag & 0x80) !== 0,
    raw: `${workchain}:${hash.toString('hex')}`,
  };
}

function toRaw(addr) {
  if (addr == null) throw new Error('address is required');
  const s = String(addr).trim();
  if (isRaw(s)) {
    const [wc, hex] = s.split(':');
    return `${parseInt(wc, 10)}:${hex.toLowerCase()}`;
  }
  if (isFriendly(s)) return parseFriendly(s).raw;
  throw new Error(`unrecognized TON address: ${addr}`);
}

function isValid(addr) {
  try {
    toRaw(addr);
    return true;
  } catch {
    return false;
  }
}

// Encode a raw `wc:hex64` to user-friendly base64url (EQ.../UQ.../kQ.../0Q...).
// Idempotent: passing a friendly address returns it unchanged (modulo
// `bounceable`/`testnet` overrides — set them to re-encode).
//
// The STON.fi native-TON pseudo-address (`0:000…000`) is meaningless as a
// real account, so we surface it as the symbolic string 'TON' — that matches
// how the rest of the codebase already tags native sides.
function toFriendly(addr, opts = {}) {
  if (addr == null) throw new Error('address is required');
  const s = String(addr).trim();
  if (s === 'TON') return 'TON';

  // Pseudo-address for native TON used by STON.fi: 0:<64 zeros>. Don't try to
  // encode it — show 'TON' so the UI doesn't mix a fake EQ string with the
  // genuine native side.
  if (s === '0:0000000000000000000000000000000000000000000000000000000000000000') return 'TON';

  let raw;
  if (isFriendly(s) && !opts.force) {
    // Already friendly. Only re-encode when caller explicitly asks (e.g. to
    // change bounceability). Otherwise short-circuit so we don't strip tag
    // info silently.
    return s;
  }
  raw = toRaw(s); // throws on garbage — desired

  const { bounceable = true, testnet = false } = opts;
  const [wcStr, hex] = raw.split(':');
  const workchain = parseInt(wcStr, 10);

  let tag = bounceable ? 0x11 : 0x51;
  if (testnet) tag |= 0x80;

  const buf = Buffer.alloc(36);
  buf[0] = tag;
  // workchain is a signed 8-bit value (masterchain is -1).
  buf.writeInt8(workchain, 1);
  Buffer.from(hex, 'hex').copy(buf, 2);
  const crc = crc16(buf.subarray(0, 34));
  buf.writeUInt16BE(crc, 34);

  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Convenience: returns `{ raw, friendly }` for any input. Skips on falsy/special
// values so call sites don't have to guard.
function bothForms(addr) {
  if (!addr) return { raw: null, friendly: null };
  try {
    const raw = toRaw(addr);
    return { raw, friendly: toFriendly(raw) };
  } catch {
    return { raw: addr, friendly: null };
  }
}

module.exports = {
  isRaw,
  isFriendly,
  isValid,
  toRaw,
  toFriendly,
  bothForms,
  parseFriendly,
};
