'use strict';

// Pure functions for the "developer reputation" pillar.
// Phase 0 produces a stub score; Phase 1 will swap in real signals.

function reputationScore({ jettons_count = 0, rugs_count = 0, alive_count = 0 }) {
  const raw = 50 + 10 * alive_count - 25 * rugs_count;
  return Math.max(0, Math.min(100, raw));
}

function confidenceLabel({ jettons_count = 0 }) {
  if (jettons_count >= 5) return 'high';
  if (jettons_count >= 2) return 'medium';
  return 'low';
}

function buildDeveloperCard(devRow) {
  if (!devRow) {
    return {
      address: null,
      jettons_count: 0,
      rugs_count: 0,
      alive_count: 0,
      reputation_score: null,
      confidence: 'unknown',
      tag: null,
    };
  }
  return {
    address: devRow.address,
    first_seen_at: devRow.first_seen_at,
    jettons_count: devRow.jettons_count,
    rugs_count: devRow.rugs_count,
    alive_count: devRow.alive_count,
    reputation_score: reputationScore(devRow),
    confidence: confidenceLabel(devRow),
    tag: devRow.tag || null,
  };
}

module.exports = { reputationScore, confidenceLabel, buildDeveloperCard };
