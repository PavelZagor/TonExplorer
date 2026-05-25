'use strict';

const axios = require('axios');

const BASE_URLS = {
  mainnet: 'https://tonapi.io',
  testnet: 'https://testnet.tonapi.io',
};

function makeTonApiClient({ network = 'mainnet', apiKey = '', timeoutMs = 12_000 } = {}) {
  const baseURL = BASE_URLS[network] || BASE_URLS.mainnet;
  const headers = { Accept: 'application/json', 'User-Agent': 'ton-explorer/0.1' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const http = axios.create({ baseURL, headers, timeout: timeoutMs });

  // (cache, in-flight) keyed by method+url+params; values are { data, expiresAt } and Promise.
  const cache = new Map();
  const inflight = new Map();

  function key(method, url, params) {
    return `${method} ${url} ${params ? JSON.stringify(params) : ''}`;
  }

  async function get(url, { params, ttlMs = 60_000 } = {}) {
    const k = key('GET', url, params);
    const now = Date.now();
    const cached = cache.get(k);
    if (cached && cached.expiresAt > now) return cached.data;
    const inflightPromise = inflight.get(k);
    if (inflightPromise) return inflightPromise;

    const p = http
      .get(url, { params })
      .then((res) => {
        cache.set(k, { data: res.data, expiresAt: Date.now() + ttlMs });
        return res.data;
      })
      .finally(() => inflight.delete(k));

    inflight.set(k, p);
    return p;
  }

  // --- High-level helpers ---
  async function getJetton(address) {
    return get(`/v2/jettons/${encodeURIComponent(address)}`, { ttlMs: 60_000 });
  }

  async function getJettonHolders(address, { limit = 100, offset = 0 } = {}) {
    return get(`/v2/jettons/${encodeURIComponent(address)}/holders`, {
      params: { limit, offset },
      ttlMs: 60_000,
    });
  }

  async function getAccount(address) {
    return get(`/v2/accounts/${encodeURIComponent(address)}`, { ttlMs: 300_000 });
  }

  async function getAccountJettons(address) {
    return get(`/v2/accounts/${encodeURIComponent(address)}/jettons`, { ttlMs: 60_000 });
  }

  async function getAccountEvents(address, { limit = 50, beforeLt } = {}) {
    return get(`/v2/accounts/${encodeURIComponent(address)}/events`, {
      params: { limit, before_lt: beforeLt },
      ttlMs: 30_000,
    });
  }

  // First-ever inbound transaction — used to derive the jetton master deployer.
  // TonAPI doesn't expose "first tx" directly; we walk events from the oldest by pulling pages until empty.
  // For Phase 0 we just grab the most recent page and return the oldest event there as a best-effort.
  // The walker (Phase 1) will do a full traversal.
  async function getProbableDeployer(masterAddress) {
    try {
      const evts = await getAccountEvents(masterAddress, { limit: 100 });
      const events = (evts && evts.events) || [];
      if (events.length === 0) return null;
      // Sort ascending by timestamp; the very first event's primary actor is our best guess.
      events.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      const first = events[0];
      const actor =
        (first.actions && first.actions[0] && (first.actions[0].simple_preview?.actor || first.actions[0]?.TonTransfer?.sender?.address)) ||
        first.account?.address ||
        null;
      return { address: actor, at: first.timestamp || null, hint: 'best-effort, page-1 only' };
    } catch (err) {
      return null;
    }
  }

  return {
    network,
    baseURL,
    get,
    getJetton,
    getJettonHolders,
    getAccount,
    getAccountJettons,
    getAccountEvents,
    getProbableDeployer,
  };
}

module.exports = { makeTonApiClient };
