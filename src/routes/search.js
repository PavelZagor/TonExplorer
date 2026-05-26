'use strict';

// GET /api/search?q=<text>&limit=20
//
// Three input modes:
//   1. Looks like a valid TON address (raw or friendly) → return as a single
//      result with kind='address' so the client can navigate without an extra
//      hop. No upstream call.
//   2. Plain text → search the local `jettons` table first (fast, no rate-limit),
//      then fall back to TonAPI `/v2/accounts/search?name=` for breadth. Hits
//      from each source are tagged with `source: 'local' | 'tonapi'`.
//   3. Empty / whitespace → 400 bad_query.

const { isValid, toRaw } = require('../lib/address');
const { searchJettons } = require('../db');

const JETTON_SUFFIX_RE = /\s*·\s*jetton\s*$/i;

function makeSearchHandler(ctx) {
  const { db, tonapi } = ctx;
  return async function search(req, res) {
    const q = String(req.query.q || '').trim();
    const limit = clampInt(req.query.limit, 1, 50, 20);

    if (!q) {
      return res.status(400).json({ ok: false, error: { code: 'bad_query', message: 'q parameter is required' } });
    }

    // (1) Address fast-path.
    if (isValid(q)) {
      let raw;
      try { raw = toRaw(q); } catch {
        return res.status(400).json({ ok: false, error: { code: 'bad_address', message: 'invalid TON address' } });
      }
      return res.json({
        ok: true,
        data: {
          query: q,
          kind: 'address',
          address: raw,
          results: [{ address: raw, name: null, symbol: null, decimals: null, source: 'input', trust: null }],
        },
      });
    }

    // (2a) Local table.
    const local = (() => {
      try { return searchJettons(db, q, limit); }
      catch (err) { req.log?.warn('local search failed', { err: err.message }); return []; }
    })();
    const seen = new Set(local.map((r) => r.address));

    const results = local.map((r) => ({
      address:  r.address,
      symbol:   r.symbol || null,
      name:     r.name   || null,
      decimals: r.decimals ?? null,
      source:   'local',
      trust:    null,
    }));

    // (2b) TonAPI fallback — fills the remaining slots with whitelisted-or-not jettons.
    if (results.length < limit) {
      try {
        const payload = await tonapi.searchAccounts(q);
        const addrs = Array.isArray(payload?.addresses) ? payload.addresses : [];
        for (const item of addrs) {
          if (results.length >= limit) break;
          const name = String(item.name || '');
          // TonAPI returns ALL account types; only keep jettons.
          if (!JETTON_SUFFIX_RE.test(name)) continue;
          let raw;
          try { raw = toRaw(item.address); } catch { continue; }
          if (seen.has(raw)) continue;
          seen.add(raw);
          results.push({
            address:  raw,
            symbol:   null,
            name:     name.replace(JETTON_SUFFIX_RE, ''),
            decimals: null,
            source:   'tonapi',
            trust:    item.trust || null,
          });
        }
      } catch (err) {
        req.log?.warn('tonapi.searchAccounts failed', { err: err.message });
      }
    }

    res.json({
      ok: true,
      data: {
        query: q,
        kind: 'text',
        results,
      },
    });
  };
}

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

module.exports = { makeSearchHandler };
