'use strict';

const { toRaw, isValid } = require('../lib/address');
const {
  upsertDeveloper,
  upsertJetton,
  recordAnalysis,
  getDeveloper,
  recordLookup,
  getWallets,
} = require('../db');
const { buildDeveloperCard } = require('../analyzers/developer');
const { pickTopHolders, concentrationFlags } = require('../analyzers/holders');

module.exports = function tokenRoute({ tonapi, db, dexDetection, config }) {
  return async function token(req, res) {
    const input = req.params.address;
    if (!isValid(input)) {
      return res.status(400).json({ ok: false, error: { code: 'bad_address', message: 'invalid TON address' } });
    }
    let raw = toRaw(input);
    let resolvedFrom = null;

    let jetton;
    try {
      jetton = await tonapi.getJetton(raw);
    } catch (err) {
      const status = err.response?.status;
      if (status === 404) {
        // If the address isn't a jetton master, see if it's a known DEX pool —
        // a very common copy-paste from tonviewer/DEX UIs. If so, transparently
        // re-target the analysis to the pool's non-TON jetton side.
        const resolved = await resolveJettonFromAccount(tonapi, raw).catch(() => null);
        if (resolved) {
          try {
            jetton = await tonapi.getJetton(resolved.jetton);
            resolvedFrom = { address: raw, address_friendly: input !== raw ? input : null, kind: resolved.kind, interface: resolved.interface };
            raw = resolved.jetton;
          } catch (err2) {
            req.log?.warn('resolved jetton also not found', { from: raw, to: resolved.jetton, err: err2.message });
            return res.status(404).json({ ok: false, error: { code: 'not_found', message: 'jetton not found' } });
          }
        } else {
          return res.status(404).json({ ok: false, error: { code: 'not_found', message: 'jetton not found' } });
        }
      } else {
        req.log?.warn('tonapi.getJetton failed', { address: raw, status, err: err.message });
        return res.status(502).json({ ok: false, error: { code: 'upstream_unavailable', message: 'tonapi unreachable' } });
      }
    }

    const metadata = jetton.metadata || {};
    const adminAddr = jetton.admin?.address || null;

    // Phase 0 deployer derivation — best effort, page-1 only.
    const probable = await tonapi.getProbableDeployer(raw).catch(() => null);
    const deployerAddr = probable?.address || null;
    const deployedAt = probable?.at || null;

    let holders = { total: jetton.holders_count || 0, top: [] };
    try {
      const holdersPayload = await tonapi.getJettonHolders(raw, { limit: 20 });
      holders = pickTopHolders(holdersPayload, 10);
      // Holders endpoint sometimes reports its own total — prefer that, fall back to master's.
      if (!holders.total) holders.total = jetton.holders_count || 0;
    } catch (err) {
      req.log?.warn('tonapi.getJettonHolders failed', { address: raw, err: err.message });
    }

    // Best-effort registry writes. Failures here must NOT fail the response.
    let devRow = null;
    try {
      if (deployerAddr) devRow = upsertDeveloper(db, deployerAddr);
      upsertJetton(db, {
        address: raw,
        deployer: deployerAddr,
        admin: adminAddr,
        symbol: metadata.symbol || null,
        name: metadata.name || null,
        decimals: metadata.decimals != null ? Number(metadata.decimals) : null,
        supply: jetton.total_supply || null,
        deployed_at: deployedAt,
        fate: 'unknown',
      });
      if (deployerAddr) devRow = getDeveloper(db, deployerAddr);
    } catch (err) {
      req.log?.warn('db write failed (non-fatal)', { address: raw, err: err.message });
    }

    const signals = concentrationFlags(holders);

    const verdict = {
      phase: 0,
      score: null,
      summary: 'Phase 0 build — verdict scoring not yet wired.',
      signals,
    };

    const top1 = holders.top[0]?.share ?? null;
    const top10 = holders.top.slice(0, 10).reduce((s, h) => s + (h.share || 0), 0) || null;

    try {
      recordAnalysis(db, { jetton: raw, score: null, verdict });
      recordLookup(db, {
        jetton: raw,
        holders_count: holders.total || jetton.holders_count || 0,
        top1_share: top1,
        top10_share: top10,
        signals,
        source_ip: req.ip || null,
      });
    } catch (err) {
      req.log?.warn('lookup persist failed (non-fatal)', { address: raw, err: err.message });
    }

    // Resolve user-managed labels for every address we are about to render.
    const addrsToResolve = [adminAddr, deployerAddr, ...holders.top.map((h) => h.address)].filter(Boolean);
    const walletMap = (() => {
      try { return getWallets(db, addrsToResolve); } catch { return new Map(); }
    })();
    const labelOf = (addr) => {
      if (!addr) return null;
      const w = walletMap.get(addr);
      if (!w) return null;
      return { label: w.label || null, tags: w.tags || [], notes: w.notes || null };
    };
    const decoratedHolders = {
      ...holders,
      top: holders.top.map((h) => ({ ...h, wallet: labelOf(h.address) })),
    };

    // Trading availability — best-effort, never block the analysis on this.
    // Empty `dexes` is a perfectly valid answer ("not listed on tracked DEXes").
    let trading = { dexes: [], primary_pool: null, primary_dex: null, paired_with: null, url: null };
    if (dexDetection) {
      try {
        const detection = await dexDetection.detectDexes(raw);
        const dexes = [];
        if (detection.dedust.pools.length > 0) dexes.push('dedust');
        if (detection.stonfi.pools.length > 0) dexes.push('stonfi');
        trading = {
          dexes,
          primary_pool: detection.primary?.pool || null,
          primary_dex:  detection.primary?.dex  || null,
          paired_with:  detection.primary?.paired_with || null,
          url: dexes.length ? `${config?.basePath || ''}/trading/${raw}` : null,
        };
      } catch (err) {
        req.log?.warn('dex-detection failed (non-fatal)', { jetton: raw, err: err.message });
      }
    }

    res.json({
      ok: true,
      data: {
        resolved_from: resolvedFrom,
        token: {
          address: raw,
          address_friendly: input !== raw ? input : null,
          name: metadata.name || null,
          symbol: metadata.symbol || null,
          decimals: metadata.decimals != null ? Number(metadata.decimals) : null,
          supply: jetton.total_supply || null,
          admin: adminAddr,
          admin_wallet: labelOf(adminAddr),
          deployer: deployerAddr,
          deployer_wallet: labelOf(deployerAddr),
          deployer_hint: probable?.hint || null,
          deployed_at: deployedAt,
          holders_count: jetton.holders_count || holders.total || 0,
        },
        developer: buildDeveloperCard(devRow),
        holders: decoratedHolders,
        verdict,
        trading,
      },
    });
  };
};

// When /v2/jettons/{addr} 404s, this checks whether `addr` is actually a DEX
// pool contract and, if so, returns its non-TON underlying jetton master so the
// route can transparently re-target the analysis. Returns null when we can't
// (or shouldn't) auto-resolve.
const POOL_INTERFACE_RE = /^(dedust_v2_cpmm|dedust_v2_pool|stonfi_pool|stonfi_pool_v2|stonfi_pool_v3)$/i;

async function resolveJettonFromAccount(tonapi, address) {
  let acct;
  try { acct = await tonapi.getAccount(address); } catch { return null; }
  const ifaces = acct?.interfaces || [];
  const hit = ifaces.find((i) => POOL_INTERFACE_RE.test(i));
  if (!hit) return null;

  let bag;
  try { bag = await tonapi.getAccountJettons(address); } catch { return null; }
  const balances = (bag?.balances || []).filter((b) => b?.jetton?.address);
  // Only auto-resolve when the pool has exactly one jetton side (the other
  // being native TON). Jetton/jetton pools are ambiguous — leave a 404 for now
  // so the user picks which side they want manually.
  if (balances.length !== 1) return null;
  return { jetton: balances[0].jetton.address, kind: 'dex_pool', interface: hit };
}
