'use strict';

// Pure functions for the "holder distribution" pillar.

function pickTopHolders(holdersPayload, take = 10) {
  const rows = (holdersPayload && holdersPayload.addresses) || [];
  const total = Number(holdersPayload?.total || rows.length);
  const supplyBn = (() => {
    // TonAPI returns total_supply at the jetton level, not in the holders payload.
    // The caller already has it; we just compute share against sum-of-top for a quick visual.
    let sum = 0n;
    for (const r of rows) {
      try { sum += BigInt(r.balance || '0'); } catch { /* skip non-numeric */ }
    }
    return sum;
  })();

  const top = rows.slice(0, take).map((r) => {
    let share = null;
    if (supplyBn > 0n) {
      try {
        const bal = BigInt(r.balance || '0');
        // share = bal / supplyBn, computed as float with 6-decimal precision
        share = Number((bal * 1_000_000n) / supplyBn) / 1_000_000;
      } catch { share = null; }
    }
    return {
      address: r.owner?.address || r.address || null,
      balance: r.balance || null,
      share,
    };
  });

  return { total, top };
}

function concentrationFlags({ top = [] } = {}) {
  const flags = [];
  if (top.length === 0) return flags;
  const top1 = top[0]?.share || 0;
  const top10 = top.slice(0, 10).reduce((s, h) => s + (h.share || 0), 0);
  if (top1 > 0.5) flags.push({ id: 'top1_majority', severity: 'high', detail: `top-1 holds ${(top1 * 100).toFixed(1)}%` });
  else if (top1 > 0.3) flags.push({ id: 'top1_heavy', severity: 'medium', detail: `top-1 holds ${(top1 * 100).toFixed(1)}%` });
  if (top10 > 0.8) flags.push({ id: 'top10_concentrated', severity: 'high', detail: `top-10 hold ${(top10 * 100).toFixed(1)}%` });
  return flags;
}

module.exports = { pickTopHolders, concentrationFlags };
