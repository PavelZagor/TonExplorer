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

  // Free-text address/name search. Returns an array of { address, name, preview, trust }.
  // `name` for jettons looks like "Tether · jetton" — the route layer strips the suffix.
  async function searchAccounts(name) {
    if (typeof name !== 'string' || !name.trim()) return { addresses: [] };
    return get('/v2/accounts/search', { params: { name: name.trim() }, ttlMs: 30_000 });
  }

  async function getAccountEvents(address, { limit = 50, beforeLt } = {}) {
    return get(`/v2/accounts/${encodeURIComponent(address)}/events`, {
      params: { limit, before_lt: beforeLt },
      ttlMs: 30_000,
    });
  }

  // Best-effort deployer derivation for Phase 0. The real walker (Phase 1) will paginate
  // backward via `before_lt` until it bottoms out; for now we only claim a deployer if
  // a single page already covers the entire history of the master account.
  //
  // Conservative rules:
  //   - if the oldest page is full (limit hit), we cannot know we've reached the start
  //     → return null with a hint, NOT a misleading guess
  //   - if the page is short, the oldest event on it is the deploy; its counterparty is
  //     the deployer — never the master itself
  async function getProbableDeployer(masterAddress) {
    const LIMIT = 100;
    let evts;
    try {
      evts = await getAccountEvents(masterAddress, { limit: LIMIT });
    } catch {
      return null;
    }
    const events = (evts && evts.events) || [];
    if (events.length === 0) return null;
    if (events.length >= LIMIT) {
      return { address: null, at: null, hint: 'history exceeds 100 events — walker required' };
    }
    // TonAPI returns events newest-first; the deploy lives at the end.
    events.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const first = events[0];
    const counterparty = extractCounterparty(first, masterAddress);
    if (!counterparty) {
      return { address: null, at: first.timestamp || null, hint: 'oldest event has no identifiable counterparty' };
    }
    return { address: counterparty, at: first.timestamp || null, hint: 'derived from first event on master account' };
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
    searchAccounts,
  };
}

// Walks a TonAPI event and returns the first non-master address it finds inside any
// action object, scanning both the typed sub-object (SmartContractExec.executor, etc.)
// and simple_preview.accounts. Returns null if every address is the master itself.
function extractCounterparty(event, masterAddress) {
  const seen = new Set();
  function walk(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.address === 'string' && obj.address !== masterAddress) return obj.address;
    if (seen.has(obj)) return null;
    seen.add(obj);
    if (Array.isArray(obj)) {
      for (const v of obj) {
        const hit = walk(v);
        if (hit) return hit;
      }
      return null;
    }
    for (const v of Object.values(obj)) {
      const hit = walk(v);
      if (hit) return hit;
    }
    return null;
  }
  for (const a of event.actions || []) {
    const hit = walk(a);
    if (hit) return hit;
  }
  return null;
}

module.exports = { makeTonApiClient };
