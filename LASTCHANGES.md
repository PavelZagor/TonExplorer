# Last Changes

Newest first. Append a fresh entry at the top of this file after every significant session. Keep entries tight — one paragraph + a bullet list, no marketing copy.

---

## 2026-05-26 — Trading page polish: live WS unblocked, trader-row icons

Three small wins on the trading page driven by a user report ("offline never goes live; clicking a wallet bounces to the main page with 'jetton not found'"). All fix-and-improve, no new endpoints.

- **nginx WS upgrade was missing.** The `/explorer/` location block only forwarded standard proxy headers — `Upgrade` / `Connection` were stripped, so the WebSocket handshake at `/explorer/api/trading/<jetton>/stream` arrived at Express as a plain GET and 404'd. Added the two `proxy_set_header` lines plus `proxy_read_timeout 3600s` (the in-app heartbeat is every 30s — 30s read timeout would borderline-kill the connection on quiet pools). Confirmed via `curl --http1.1 -H 'Upgrade: websocket' …` returning `101 Switching Protocols` + the `subscribed` greeting. Documented in `docs/06-deployment.md` so this doesn't bite again on a fresh deploy.
- **Trader column UX.** Each row now exposes three affordances next to the trader address: the address itself opens tonviewer in a new tab (we don't have a wallet-analysis page in-project yet), 🔎 scopes the trades table to that single trader with a dismissable banner showing the active filter, and ✎ opens the same label/tags/notes overlay as the main page. The overlay reuses the existing `/api/admin/wallet/:address` admin endpoint and the `tonexplorer.admin_token` localStorage key so a token set on the main page works on the trading page without re-entry.
- **Live indicator tooltip honesty.** Off→on tooltip used to say "REST-only (live stream not wired yet)" — that's been wrong since step 6 of the original feature. Now reads "No WebSocket — refresh page to see new trades", which matches what actually happens server-side (8s polling continues even without a WS subscriber).
- Click on the trader address previously did `?address=<wallet>` against `/api/token/…`, which always returned `jetton_not_found` because the trader is a wallet, not a jetton master. That dead-end is now the tonviewer external link.

---

## 2026-05-25 — LP-aware concentration flags

Direct follow-on to the trading work earlier today. The screening verdict used to count DEX pools as ordinary concentration: a pool sitting in the top-N holders would inflate top1/top10 and fire a "majority" flag for what is actually liquid supply. Now every top holder is annotated `is_lp` from a live join against the detection result for that jetton, and `concentrationFlags` skips them before computing sums.

- `src/analyzers/holders.js::concentrationFlags` filters out `is_lp` holders (or `wallet.tags ∋ 'lp'`) before reducing top1/top10. When LPs were excluded, the detail line gets a `(LP excluded: N)` suffix so the UI can show why the number changed.
- `src/routes/token.js` reorders the work: detection runs first, the resulting `dedust.pools + stonfi.pools` addresses are projected into a `Set`, and each holder is annotated `is_lp` against it. `lookups.top1_share` / `top10_share` history rows are now LP-adjusted too so future time-series UI doesn't get noise from a pool growing/shrinking.
- `views/index.html` renders an `LP (auto)` cyan chip on each LP-marked holder row and softens the row opacity so it visually drops out of the concentration story.
- `src/db/index.js` gets `selectKnownPoolAddresses(db, addrs)` — not used by this change (which prefers in-memory matching against the detection result) but useful for future analyzers that need to recognise pool addresses across jettons.
- Tests: 7 new in `tests/holders-lp.test.js` (top-1 majority, LP-at-top-1 ignored, mixed LP / non-LP with detail suffix, manual `wallet.tags`, top-10 sums, all-LP, isLpHolder predicate). Total suite 32 pass / 0 fail.

Note on the stale CLAUDE.md anecdote: "PUTIN's top-1 (26.66%) is the DeDust pool" doesn't reproduce — PUTIN isn't on DeDust today (zero pools in the bulk list). The unit tests cover the intent regardless.

---

## 2026-05-25 — Trading page with DeDust integration

Fourth pillar of the analyzer lands: real-time-ish trade feed + candle chart for every jetton listed on a tracked DEX. DeDust gets the full stack (detection / trades / candles / live WS stream); STON.fi gets detection-only because their full integration would double the surface and the demand isn't there yet. Spec was shipped in 10 commits, one per step from the archived TZ at `docs/plans/2026-05-25-trading-feature.md`.

- **New schema** in `003_trading.sql`: `trading_pools` / `trades` / `trading_sync_state`. Trade rows key by `(pool_address, lt)` — DeDust's REST does not return tx hash. No `raw_trace_json` column (anti-pattern §12), no USD columns (DeDust REST doesn't expose USD).
- **New services**: `dedust-client` (bulk pool list cached 5 min with stale-fallback, trade history re-sorted newest-first), `stonfi-client` (same cache shape for `/v1/pools`; handles STON.fi's all-zeros TON pseudo-address), `dex-detection` (parallel gather across both DEXes, picks primary by largest TON-paired reserve_quote), `candle-builder` (1m / 5m / 15m / 1h / 4h / 1d bucket math, volume in `paired_with` units), `trade-parser` (normalises DeDust REST swaps onto the `trades` row shape, side relative to the pool's jetton_master), `trade-stream` (EventEmitter, per-pool refcount + 8s poll, dedup by `lt`, emits `trade` events).
- **New routes**: `GET /api/trading/:jetton/info` / `/trades` / `/candles`, `GET /api/search?q=&limit=` (address fast-path + local jettons + TonAPI fallback), `WS /api/trading/:jetton/stream` (refcounted via tradeStream, JSON heartbeat + native ping every 30s). The existing `/api/token/:address` response gained a `trading: {dexes, primary_pool, primary_dex, paired_with, url}` field.
- **New view**: `views/trading.html` — vanilla HTML + Tailwind CDN + TradingView Lightweight Charts 4.2.0 via CDN. Candle chart with interval pills + auto-widen-to-30d on empty 24h window, trades table with relative timestamps and buy/sell pills, "Load older" pagination, capped-exponential WS reconnect. `views/index.html` gained a debounced search dropdown above the existing Analyze button + a Trading badge card next to the verdict.
- **Architectural choice**: live updates are driven by DeDust polling, not TonAPI WS push. Confirmed via Explore that sibling `ton-bot` is REST-only — no WS precedent in the codebase. The trade-parser interface is push-shape-agnostic, so a TonAPI WS path can be added later without changing the row shape or the WS client.
- **Tests**: `npm test` wired via `node:test`. 25 tests across `dex-detection`, `stonfi-detection`, `candle-builder`, `trade-stream`. All passing.
- **Smoke**: USDT (`EQCxE6mU…sDs`) detected on both `['dedust', 'stonfi']`, primary pool resolves to the canonical TON/USDT pair (DeDust pool `0:3e5f…5588`, reserves ~178.9 k TON / 452.4 k USDT), live trades parse with `price_native ≈ 0.395 TON/USDT`. PUTIN (canonical test jetton) correctly reports `dexes: []` everywhere — it's not on DeDust, so the trading page surfaces a friendly "Not listed" empty state and the WS rejects with `{code:'not_listed'}`. Bogus addresses fail at `bad_address` (HTTP) / socket-destroy (WS).
- **Docs**: new `docs/07-trading.md` (architecture + schema + WS protocol + "how to add a DEX"). `docs/02-data-sources.md` and `docs/05-api.md` updated with the DeDust + STON.fi probed surface and every new endpoint. `ROADMAP.md` gets a Phase 1.5 section. `TODO.md` ticks the trading line and adds the new follow-ups (full STON.fi integration, LP-aware concentration flags, TonAPI WS option, USD overlay).

Pre-flight note that paid off: the spec assumed `/v2/jetton/:address`; our actual route is `/api/token/:address` and the migration runner reads `*.sql` files, not a single `migrations.js`. Both were captured in the archived plan before this session started, so step 1 lined up the first commit cleanly.

---

## 2026-05-25 — Wallet registry + lookups history + admin editor

First user-managed state lands. Every token analysis now persists a snapshot row in `lookups` (append-only, future time-series feed). Every address we render in the UI is resolved against a new `wallets` table so the maintainer can attach labels, free-form notes, and a bounded set of tags (`lp / mev / farm / cex / rugger / trusted` plus free-form, lowercased + punctuation-stripped, max 8). Wallets can also be linked to other wallets via `wallet_links` with a constrained kind set (`funded_by / cluster_with / controls`).

- **Migration `002_lookups_and_wallets.sql`** — three tables plus indexes. `wallets.tags` is a JSON array column (stringified) and parsed at the DB-helper boundary so callers always see a real array.
- **Admin subtree under `/api/admin/*`** (write-capable). Gated by a Bearer token from `ADMIN_TOKEN` in `.env` (generate via `openssl rand -hex 32`). When the env var is unset, the entire subtree responds 503 `admin_disabled` — fail-closed. Public read-only routes are untouched: the GET-only method guard now exempts only the admin prefix.
- **Token route bulk-resolves labels** via `getWallets(db, addresses)` for `{admin, deployer, holders.top[].address}` in a single SQL `IN (…)` query. Response gains `admin_wallet`, `deployer_wallet`, and `holders.top[].wallet` fields.
- **UI** — `renderAddress(addr, wallet, opts)` is the single source of truth for how addresses are drawn (label + short addr + tag chips + ✎ pencil). Pencil opens an overlay editor pre-filled from `GET /api/admin/wallet/:address`; saving PUTs back. On 401 the user is prompted for the token (stored in `localStorage['tonexplorer.admin_token']`). A ⚙ icon in the header lets you set/clear the token without going through an edit flow. Preset tags render as toggleable colour-coded chips; free-form tags can be typed in the comma input below.
- **Smoke** (against `https://your-server.example.com/explorer/`): 401 without/with bogus token; 200 saves "PUTIN/TON DeDust pool" + `lp` tag on the pool address; subsequent `GET /api/token/<PUTIN master>` shows the label on holder #1; lookups table accumulates rows; link validation rejects bogus kinds and self-links.

Known gap exposed by this session: PUTIN's top-1 holder is the labelled LP pool (26.66% of supply) but `concentrationFlags` still counts it as ordinary concentration. Marked as the next backlog item — "LP-aware concentration flags".

---

## 2026-05-25 — PM2 + nginx, public dev URL live

TonExplorer now runs under PM2 and is reachable via TLS at `https://your-server.example.com/explorer/`. The same `0:3a14…7c14` PUTIN smoke that worked locally now works end-to-end through nginx.

- Added committed `ecosystem.config.js` at the repo root. Self-locating via `cwd: __dirname`; every runtime knob (PORT, BASE_PATH, TONAPI_KEY, …) is loaded from `.env` inside `src/server.js`. No host-specific path in the committed file. PM2 list saved with `pm2 save`.
- `logs/` is created by the deployment step; PM2 writes `ton-explorer.{out,err}.log` there. Each line is the structured JSON our logger emits (PM2 only adds a `id|name |` prefix during `pm2 logs`, on-disk files stay clean), so we don't set `log_date_format` or every line would be double-stamped.
- Added a `location ^~ /explorer/` block to the dev host's nginx SSL server block, proxying to `127.0.0.1:3031` with `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto` set. Backed up the original config before editing, then `nginx -t && systemctl reload nginx`. (Backup placed outside `sites-enabled/` so nginx doesn't try to parse it as a second vhost.)
- `docs/06-deployment.md` updated to describe the committed `ecosystem.config.js` directly instead of the old "make a local `ecosystem.local.config.js`" pattern. Hostname placeholder kept as `your-server.example.com` — real hostname stays only in `.env`.

---

## 2026-05-25 — First mainnet smoke + structured logging

First end-to-end run against TonAPI mainnet (USDt, HMSTR, LUNEXMEME). Smoke surfaced two real defects in the Phase 0 code, both fixed.

- **Deployer derivation was lying.** `src/lib/tonapi.js::getProbableDeployer` was falling back to `event.account.address` (the master itself) when no counterparty could be parsed, so every popular token's "deployer" was its own master address. Rewrote it conservatively: walk every action object's typed sub-tree, return the first non-master address found, AND refuse to claim a deployer at all unless the master's history fits in a single 100-event page (i.e. we've actually reached the start of history). Otherwise return `null` + hint `"history exceeds 100 events — walker required"`. Verified: USDt/HMSTR now correctly return `null`; LUNEXMEME (2 lifetime events) correctly resolves to `0:8247…7c14`.
- **`developers.jettons_count` never incremented.** `upsertJetton` only touched the `jettons` table; the denormalized counters on `developers` stayed at 0 forever. Replaced with on-read aggregation in `getDeveloper` — `jettons_count / rugs_count / alive_count` are now computed via `SELECT COUNT(*) … WHERE deployer = ?` on every fetch, so they can't drift. The denormalized columns remain in the schema (zero-defaulted, harmless) and will be dropped in a later migration.
- **Structured JSON logging.** New `src/lib/logger.js` (zero deps) emits one-line JSON per event with `ts/level/msg/app` + arbitrary fields. Bound an Express middleware that tags every request with a short `req_id` and logs method/path/status/duration_ms on response finish. Replaced every bare `console.*` in `server.js`, `routes/token.js`, `db/index.js`. PM2 / journald can ingest these directly.
- Cleared `data/explorer.sqlite` (it held seed rows from the broken deployer derivation). Will rebuild from real analyses.

---

## 2026-05-25 — First push to GitHub

Translated all UI strings in `views/index.html` and a stale "respond in Russian" line in `CLAUDE.md` to English — the repo is now English-only across all committed artifacts. Added an MIT `LICENSE` file. Initialized git in `/www/crypto/explorer/`, made the initial commit (29 files, 3448 LOC), set up an SSH deploy key (`/root/.ssh/ton-explorer-deploy`, ed25519, write access scoped to this single repo via `Host github-tonexplorer` alias in `~/.ssh/config`), and force-with-lease pushed over the GitHub-auto-generated placeholder commit. Remote `main` now matches local `main` at `b96985e`.

- Public repo live: https://github.com/PavelZagor/TonExplorer
- Confirmed `.env`, `data/`, `node_modules/` are absent from the pushed tree
- Confirmed the dev-server hostname is absent from every committed file
- `git remote -v` uses the SSH alias, not raw `git@github.com`, so future `git push` here uses the deploy key without touching other GitHub auth on this host

---

## 2026-05-25 — Project kickoff

Created the repository skeleton for TonExplorer in `/www/crypto/explorer/`. No on-chain logic yet — this is the foundation Phase 0 from the roadmap.

- Decided stack: Node.js + Express, TonAPI as primary data source, SQLite for the developer registry, vanilla HTML + Tailwind via CDN, public read-only API. Matches the sibling `ton-bot` conventions.
- Wrote project docs: `README.md`, `ROADMAP.md`, `TODO.md`, `CLAUDE.md`, `docs/01-architecture.md` … `docs/06-deployment.md`.
- Wrote `.env.example` covering server config, TonAPI / TonCenter keys, SQLite path, rate-limit knobs, and a placeholder Telegram section for Phase 4.
- `.gitignore` blocks `.env`, `data/`, `logs/`, `node_modules/`, and `*.local.md` (escape hatch for host-specific notes that must stay off GitHub).
- Express skeleton: boots on `PORT` (default 3031), mounts everything under `BASE_PATH` (default `/explorer`), serves `views/index.html`, exposes `/api/health`, `/api/token/:address` (stub), opens SQLite via `better-sqlite3` and runs migrations on boot. Developer/jetton/analysis tables created empty.
- Minimal UI: single input box that calls the API and pretty-prints the JSON response.

Next session: `npm install`, end-to-end smoke against mainnet TonAPI, wire PM2.
