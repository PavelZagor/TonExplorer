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

module.exports = function tokenRoute({ tonapi, db }) {
  return async function token(req, res) {
    const input = req.params.address;
    if (!isValid(input)) {
      return res.status(400).json({ ok: false, error: { code: 'bad_address', message: 'invalid TON address' } });
    }
    const raw = toRaw(input);

    let jetton;
    try {
      jetton = await tonapi.getJetton(raw);
    } catch (err) {
      const status = err.response?.status;
      if (status === 404) {
        return res.status(404).json({ ok: false, error: { code: 'not_found', message: 'jetton not found' } });
      }
      req.log?.warn('tonapi.getJetton failed', { address: raw, status, err: err.message });
      return res.status(502).json({ ok: false, error: { code: 'upstream_unavailable', message: 'tonapi unreachable' } });
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

    res.json({
      ok: true,
      data: {
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
      },
    });
  };
};
