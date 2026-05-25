# 04 — MEV & bot-farm detection

This is the hardest part of TonExplorer and the place where heuristics will keep evolving. This document is what we're aiming at, not what's implemented yet (Phase 3 in [`../ROADMAP.md`](../ROADMAP.md)).

## What we're actually looking for

On TON, classical Ethereum-style MEV (sandwich attacks) is less common because TON's mempool model is different and there's no public mempool with arbitrary ordering. The threats that matter for jetton screening are:

1. **Coordinated pumping by a bot farm.** Many wallets, funded by the same parent, buying a fresh jetton in a tight window to manufacture volume and chart shape.
2. **Wash trading.** A small set of wallets ping-ponging the token between themselves to fake liquidity and trading activity.
3. **Snipers.** Bots that monitor for new LP creation and buy in the very first block, then dump on retail. The deployer is often in on it or *is* the sniper.
4. **Insider-cluster buys.** Wallets close to the deployer (received TON from them, or share a funding parent) loading up before the token is publicly known.

## Signals (each becomes a feature)

### S1 — Common funding parent

For the first N buyers of a fresh jetton, trace each buyer's first-ever incoming TON transfer (the "birth" tx). Cluster by the source address. If 10+ buyers all funded from the same wallet within a small time window, that wallet is the bot operator.

### S2 — Synchronized buy windows

Bucket the first 24h of trades into 5-second windows. Count distinct buyer addresses per window. A high count of fresh wallets in a single window = scripted buy, not organic interest.

### S3 — Round-trip wash signature

Detect pairs `(A, B)` where over a short window `A → B` and `B → A` transfers cancel out to within rounding, repeatedly. Volume that nets to zero is wash volume.

### S4 — Sniper pattern across launches

Wallets that have appeared in the *first block* of LP creation across multiple jettons. These are professional snipers. Maintain a separate `snipers` table that grows over time; flag any new launch where a known sniper has already entered.

### S5 — Insider cluster

For the deployer address, list every TON-funded wallet within 7 days before the jetton launch. Check whether any of those wallets bought the jetton in the first hour. They probably knew.

### S6 — Holder graph density

Among the first 100 holders, count how many pairwise transferred TON or jettons to each other in the 30 days prior. High pairwise connectivity = preexisting cluster, not 100 independent retail buyers.

## Aggregation

Each signal scores 0–1. Aggregate score is a weighted sum, weights TBD as we calibrate against known-bad and known-good examples. The UI shows:

- The overall `pump_likelihood` 0–100.
- The top 2–3 signals that contributed to it, in plain language.
- A drill-down table of the clustered wallets, sortable.

Explainability is mandatory — a black-box "this is suspicious" verdict is worse than nothing, because users will either over-trust or ignore it.

## Data requirements

Each of these signals needs more raw data than a single TonAPI call provides:

- S1 and S5 need account histories. ~1 TonAPI call per address; for 50 early buyers that's 50 calls.
- S3 and S6 need a transfer graph. Pull all transfers of the jetton (and the TON funding around the launch) into SQLite, build the graph in memory.
- S4 needs cross-jetton state; that's where the `snipers` table earns its keep.

We'll likely run S1–S6 as a **background analysis job** rather than synchronously inside the request. The web UI shows "deep analysis in progress" and polls. SQLite stores the result.

## Calibration

Before trusting any of these signals in the UI verdict, we calibrate against:

- **Known-bad set:** ~20 confirmed rug-pulled jettons (manually curated from public reports).
- **Known-good set:** ~10 jettons that have been alive for 6+ months with healthy distribution.

Walk every signal over both sets. Anything that doesn't separate the two cleanly comes out of the score (we can still display it in the UI for transparency, just unweighted).

## What we are *not* claiming

- This is not a real-time MEV protection service for traders. There is no signing here, no transaction submission.
- The signals catch unsophisticated bot farms cleanly. Sophisticated actors who use mixers, fresh-from-CEX funding, and patient buy schedules will look closer to organic. We'll surface the uncertainty rather than pretend the verdict is reliable.
- We don't attempt to dox anyone. All identifiers are on-chain addresses.
