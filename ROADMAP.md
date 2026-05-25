# TonExplorer — Roadmap

Working horizon: roughly 3 months from kickoff (2026-05-25). Phases are sequential but small bits from later phases can slip into earlier ones if cheap.

---

## Phase 0 — Foundation (week 1)

Goal: skeleton you can point at a jetton address and get *something* back. No reputation logic yet.

- [x] Repo layout, README, ROADMAP, TODO, docs scaffolding
- [x] `.env` / `.env.example` separation; gitignore secrets
- [ ] Express server boots on configurable `PORT` + `BASE_PATH`
- [ ] TonAPI HTTP client with optional API key + simple in-memory cache
- [ ] `GET /api/token/:address` returns raw jetton master info (name, symbol, supply, holders count, admin/deployer)
- [ ] Static `views/index.html` — input field + JSON dump of the response
- [ ] SQLite opened on boot, migrations runner, empty `developers` table

**Exit criteria:** open the URL, paste a jetton address, see a populated card with on-chain basics.

---

## Phase 1 — Developer reputation (weeks 2–3)

Goal: every time we analyze a token, we learn something about its deployer.

- [ ] Schema: `developers`, `jettons`, `analyses` tables
- [ ] On every `/api/token/:address` hit, upsert deployer + record link to jetton
- [ ] Background-walker (manual trigger first, then cron): for each known developer, list other jettons they deployed
- [ ] Per-jetton "fate" classifier: `alive | dead | rugged | unknown` based on simple signals (last tx age, holders dropping, admin renounce status, LP drained)
- [ ] Aggregate reputation score for a developer: counts + ratios of fates
- [ ] UI: "Developer card" panel below token card — total jettons launched, success/rug rate, links to other tokens
- [ ] Manual override / notes: admin-only endpoint to tag a developer (e.g. "confirmed rugger")

**Exit criteria:** analyzing a fresh token from a known rugger immediately surfaces a red flag with links to prior rugs.

---

## Phase 2 — Holder & liquidity analysis (week 4)

Goal: catch the easy ways scams look obvious if you look at the cap table.

- [ ] Top-N holders breakdown with percentage of supply
- [ ] Concentration metric (Gini / Herfindahl over top holders)
- [ ] Fresh-wallet ratio (holders created within N days of the jetton)
- [ ] LP detection (STON.fi / DeDust pools), LP locked / burned check
- [ ] Mint authority status (renounced / still active), upgradability flags
- [ ] UI: "Distribution" panel with bar chart of top holders

**Exit criteria:** UI shows clear warnings when supply is concentrated, LP is unlocked, or mint is still active.

---

## Phase 3 — MEV / bot-farm detection (weeks 5–7)

Goal: spot coordinated pumping on fresh tokens. This is the heuristic-heavy phase; expect iteration.

- [ ] Fetch full early trade history of a jetton (first N hours after launch)
- [ ] Cluster buyer wallets by common funding source (parent wallet)
- [ ] Detect synchronized-block buying (multiple wallets, same block, same router)
- [ ] Wash-trade signature: same wallet pair repeatedly back-and-forth, small notional
- [ ] Sniper detection: wallets that buy within the first block of LP creation, repeated across many tokens
- [ ] Score: `pump_likelihood` (0–100) with explainable contributors
- [ ] UI: "Activity" panel with timeline + flagged clusters

**Exit criteria:** for a known pumped token, the tool surfaces the bot cluster and shows when the coordinated buying happened.

---

## Phase 4 — Telegram bot (week 8)

Goal: the same analysis, invokable from a Telegram chat.

- [ ] Bot scaffold (long-polling first; webhook later if needed)
- [ ] `/analyze <jetton_address>` command — returns the same verdict as the web UI, summarized
- [ ] Inline-mode lookup
- [ ] Watchlist: subscribe to a deployer or jetton, get alerts on new events
- [ ] Group-chat mode with rate-limit per chat

**Exit criteria:** can analyze a token end-to-end from a Telegram chat without opening the web UI.

---

## Phase 5 — Continuous indexer & alerts (weeks 9–12)

Goal: stop being purely reactive. Surface fresh jettons proactively.

- [ ] Background poller for newly deployed jetton masters
- [ ] Auto-analyze each new jetton, store verdict
- [ ] "New today" feed in the web UI, sortable by score
- [ ] Telegram alerts for high-risk or high-interest new launches
- [ ] Public read-only API endpoint listing recent analyses

**Exit criteria:** without any user action, TonExplorer has a live feed of fresh jettons with verdicts attached.

---

## Backlog (not scheduled)

- Postgres migration once SQLite volume / write pressure justifies it
- Multi-network: testnet alongside mainnet in the same UI
- DEX-specific risk signals (STON.fi v2, DeDust, etc.)
- ML model trained on labeled rugs (post sufficient labeled data)
- Browser extension that injects verdicts into Tonviewer / tonscan
- Cross-chain comparison: are these deployer wallets known on EVM/Solana?
- Public API with rate-tiering (would require auth — defer)
