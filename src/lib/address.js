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

module.exports = {
  isRaw,
  isFriendly,
  isValid,
  toRaw,
  parseFriendly,
};
