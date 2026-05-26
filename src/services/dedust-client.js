'use strict';

// Thin HTTP wrapper around the DeDust v2 REST API.
//
// Surface notes (probed 2026-05-25 against https://api.dedust.io/):
//   GET /v2/pools                            -> 200, ~24 MB JSON, every pool on every factory.
//   GET /v2/pools/{addr}                     -> 404 (no per-pool endpoint).
//   GET /v2/pools/{addr}/trades?page_size=N  -> 200, JSON array, oldest-first.
//   /v2/jettons, /v3/*, /v2/factories        -> 404. Don't use.
//
// Because there is no per-pool info endpoint, pool lookup is implemented as a
// filter over the cached bulk list (`getPools()`). 24 MB / 50 k pools is a lot
// to keep in memory but cheaper than re-fetching, and the rate limit on the
// bulk endpoint is what we're really respecting.

const axios = require('axios');

const DEFAULT_BASE_URL = 'https://api.dedust.io/v2';
const DEFAULT_CACHE_TTL_SEC = 300;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_BULK_TIMEOUT_MS = 30_000; // bulk /pools is multi-MB; allow longer

function makeDedustClient({
  baseURL = DEFAULT_BASE_URL,
  cacheTtlSec = DEFAULT_CACHE_TTL_SEC,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = null,
} = {}) {
  const http = axios.create({
    baseURL,
    timeout: timeoutMs,
    headers: { Accept: 'application/json', 'User-Agent': 'ton-explorer/0.1 (+dedust-client)' },
  });

  // Bulk pool cache. One entry per `baseURL`. The cached value can be either:
  //   { kind: 'fresh',   pools, expiresAt }   — within TTL
  //   { kind: 'stale',   pools, fetchedAt  }  — past TTL but kept as graceful fallback
  // In-flight fetch is deduplicated so concurrent requests share one HTTP call.
  let cache = null;
  let inflight = null;

  async function fetchPoolsFresh() {
    if (inflight) return inflight;
    const startedAt = Date.now();
    inflight = http
      .get('/pools', { timeout: DEFAULT_BULK_TIMEOUT_MS })
      .then((res) => {
        const pools = Array.isArray(res.data) ? res.data : [];
        cache = { kind: 'fresh', pools, expiresAt: Date.now() + cacheTtlSec * 1000, fetchedAt: Date.now() };
        if (logger) logger.info('dedust pools fetched', { count: pools.length, ms: Date.now() - startedAt });
        return pools;
      })
      .catch((err) => {
        // On error, keep stale data if we have any, but surface the error to the
        // caller so they can decide whether to serve stale or fail.
        if (logger) logger.warn('dedust pools fetch failed', { err: err.message, status: err.response?.status });
        if (cache && cache.pools && cache.pools.length > 0) {
          cache = { kind: 'stale', pools: cache.pools, fetchedAt: cache.fetchedAt };
        }
        throw err;
      })
      .finally(() => { inflight = null; });
    return inflight;
  }

  // Returns the raw DeDust pool array. Serves a fresh cache when one exists,
  // otherwise refetches. Throws only when there is no cache AND the fetch fails.
  async function getPools() {
    const now = Date.now();
    if (cache?.kind === 'fresh' && cache.expiresAt > now) return cache.pools;
    try {
      return await fetchPoolsFresh();
    } catch (err) {
      if (cache?.pools?.length) {
        if (logger) logger.warn('dedust serving stale pools after fetch failure', { age_sec: Math.round((now - cache.fetchedAt) / 1000) });
        return cache.pools;
      }
      throw err;
    }
  }

  // Trade history for a single pool. `beforeLt` paginates older. DeDust returns
  // oldest-first within a page — we expose results in newest-first order so the
  // rest of the codebase doesn't have to worry about it.
  async function getPoolTrades(poolAddress, { pageSize = 100, beforeLt = null } = {}) {
    const url = `/pools/${encodeURIComponent(poolAddress)}/trades`;
    const params = { page_size: pageSize };
    if (beforeLt) params.before_lt = beforeLt;
    const res = await http.get(url, { params });
    const list = Array.isArray(res.data) ? res.data : [];
    // Reverse to newest-first. `lt` is a 64-bit decimal string so we sort numerically as bigint.
    return list.slice().sort((a, b) => (BigInt(b.lt) > BigInt(a.lt) ? 1 : BigInt(b.lt) < BigInt(a.lt) ? -1 : 0));
  }

  // Test-only: force-flush the cache (used by unit tests; not exported via the
  // factory's normal return surface to avoid accidental production calls).
  function _resetCacheForTest() { cache = null; inflight = null; }

  return {
    baseURL,
    getPools,
    getPoolTrades,
    _resetCacheForTest,
  };
}

module.exports = { makeDedustClient };
