'use strict';

// Minimal STON.fi v1 client. Detection-only for now — no trades / candles.
//
// /v1/pools returns the entire pool registry (~43k rows / 43 MB). We cache it
// for `cacheTtlSec` (default 300s) the same way the DeDust client does. Native
// TON is represented as the burn-style friendly address
// `EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c` which normalises to the
// all-zeros raw — that's how we recognise the "TON side" of a pool.

const axios = require('axios');

const DEFAULT_BASE_URL = 'https://api.ston.fi/v1';
const DEFAULT_CACHE_TTL_SEC = 300;
const DEFAULT_BULK_TIMEOUT_MS = 30_000;

// `EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c` → raw all-zeros.
const TON_PSEUDO_RAW = '0:0000000000000000000000000000000000000000000000000000000000000000';

function makeStonfiClient({
  baseURL = DEFAULT_BASE_URL,
  cacheTtlSec = DEFAULT_CACHE_TTL_SEC,
  logger = null,
} = {}) {
  const http = axios.create({
    baseURL,
    timeout: DEFAULT_BULK_TIMEOUT_MS,
    headers: { Accept: 'application/json', 'User-Agent': 'ton-explorer/0.1 (+stonfi-client)' },
  });

  let cache = null;
  let inflight = null;

  async function fetchPoolsFresh() {
    if (inflight) return inflight;
    const startedAt = Date.now();
    inflight = http
      .get('/pools')
      .then((res) => {
        const list = Array.isArray(res.data?.pool_list) ? res.data.pool_list : [];
        cache = { kind: 'fresh', pools: list, expiresAt: Date.now() + cacheTtlSec * 1000, fetchedAt: Date.now() };
        if (logger) logger.info('stonfi pools fetched', { count: list.length, ms: Date.now() - startedAt });
        return list;
      })
      .catch((err) => {
        if (logger) logger.warn('stonfi pools fetch failed', { err: err.message, status: err.response?.status });
        if (cache?.pools?.length) cache = { kind: 'stale', pools: cache.pools, fetchedAt: cache.fetchedAt };
        throw err;
      })
      .finally(() => { inflight = null; });
    return inflight;
  }

  async function getPools() {
    const now = Date.now();
    if (cache?.kind === 'fresh' && cache.expiresAt > now) return cache.pools;
    try { return await fetchPoolsFresh(); }
    catch (err) {
      if (cache?.pools?.length) {
        if (logger) logger.warn('stonfi serving stale pools', { age_sec: Math.round((now - cache.fetchedAt) / 1000) });
        return cache.pools;
      }
      throw err;
    }
  }

  function _resetCacheForTest() { cache = null; inflight = null; }

  return {
    baseURL,
    getPools,
    TON_PSEUDO_RAW,
    _resetCacheForTest,
  };
}

module.exports = { makeStonfiClient, TON_PSEUDO_RAW };
