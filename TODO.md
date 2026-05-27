# TonExplorer — TODO

Active sprint = **Phase 0 (Foundation)** from [`ROADMAP.md`](./ROADMAP.md). Check items off here as they ship; sweep completed items into `LASTCHANGES.md` at session end.

## Right now (Phase 0 — Foundation)

- [x] Project layout (`src/`, `views/`, `docs/`, `data/`)
- [x] `package.json` with deps pinned (`express`, `axios`, `better-sqlite3`, `dotenv`)
- [x] `.env.example` covering every config knob
- [x] `.gitignore` covers `.env`, `data/`, `logs/`, `node_modules/`
- [x] README / ROADMAP / TODO / LASTCHANGES / CLAUDE.md
- [x] `docs/01-architecture.md` … `docs/06-deployment.md`
- [x] Express server skeleton — boots on `PORT`, mounts under `BASE_PATH`, serves `views/index.html`
- [x] `/api/health` returns version + uptime
- [x] TonAPI client wrapper (`src/lib/tonapi.js`) — handles auth header, base URL, simple cache
- [x] `GET /api/token/:address` returns jetton master info via TonAPI
- [x] SQLite open + migration runner; tables: `developers`, `jettons`, `analyses`
- [x] Upsert deployer + jetton on every successful analysis
- [x] Minimal UI: address input, "Analyze" button, JSON dump fallback + a few formatted cards

## Next up (start of Phase 1)

- [x] `npm install` on the dev host and a real end-to-end smoke test against mainnet TonAPI
- [x] Add structured logging (timestamps, request ID) instead of bare `console.log`
- [x] Developer reputation card in UI (already shipped in Phase 0; counters now computed on-read)
- [x] Wire up to PM2 (`ecosystem.config.js` committed — generic, `cwd: __dirname`, all knobs from `.env`)
- [x] nginx vhost snippet documented in `docs/06-deployment.md` (placeholder hostname only); live on the dev host behind TLS via a `location ^~ /explorer/` block
- [x] **Lookups history table** — every `/api/token/:address` hit persists a `(jetton, ts, holders_count, top1_share, top10_share, signals, source_ip)` row (append-only). Enables future time-series UI.
- [x] **Wallet registry** — `wallets` (address PK + label + notes + tags) and `wallet_links` (from_addr → to_addr with kind ∈ {funded_by, cluster_with, controls}). Token route now bulk-resolves labels for admin/deployer/top-holders.
- [x] **Admin endpoints (Bearer-auth)** — `GET/PUT /api/admin/wallet/:address`, `POST /api/admin/wallet/:address/links`, `DELETE /api/admin/wallet/links/:id`. Gated by `ADMIN_TOKEN` in `.env`; 503 when unset, 401 on bad token.
- [x] **UI: inline editor** — pencil ✎ next to every rendered address opens a label/tags/notes form, plus a ⚙ settings overlay for the admin token (stored in localStorage).
- [ ] Background developer-walker: `node tools/walk-developers.js` paginates `/v2/accounts/.../events` with `before_lt` until the bottom, then upserts every jetton the deployer ever shipped
- [ ] Per-jetton fate classifier v0: `alive | dead | rugged | unknown` based on `last_tx_age`, `holders_count`, `mint_active`
- [ ] Tighten deployer derivation: today we only claim a deployer if the master account has ≤100 lifetime events. Once the walker exists, drop the page-1 limit and reuse the walker's pagination here too.
- [ ] `GET /api/token/:address/history` — return last N rows from `lookups`; render as a sparkline of `holders_count` + a verdicts list in the UI.
- [ ] **Trade history** (largest piece). Background indexer per "interesting" jetton: paginate `/v2/blockchain/accounts/{master}/transactions` with `before_lt` until either we hit the 30-day cutoff or the start of history. Store in a new `jetton_trades` table; expose a timeline panel. (At ~700ms / 100 tx, a busy meme like PUTIN takes ~20 min for a month, so this is strictly background, not on-demand.)
- [ ] **LP-aware concentration flags** — once a `wallet.tags` contains `lp`, exclude that holder from the top-N concentration sums. Today PUTIN's top-1 (26.66%) is the DeDust pool, so the no-signals verdict is the right call but for the wrong reason.
- [x] **Trading page with DeDust integration** — shipped 2026-05-25 in 10 commits (one per spec step). DeDust trades + candles + live WS stream, STON.fi detection-only, jetton search, screening-page trading badge. See [`docs/07-trading.md`](./docs/07-trading.md) and `LASTCHANGES.md`.
- [x] **Trading page: trader-row icons + live WS unblocked** — nginx `Upgrade`/`Connection` headers added so the live stream connects; ✎ rename and 🔎 filter icons on every trader row, address text now opens tonviewer in a new tab (no more `?address=<wallet>` dead-end). 2026-05-26.
- [x] **Friendly EQ display everywhere** — `toFriendly()` lib + `*_friendly` annotations across `/api/token`, `/api/trading/*`, WS trade messages, developer card. Both `views/*.html` prefer friendly with raw kept in the tooltip. SCAT-style "admin = zero address" now shows as renounced. 2026-05-27.
- [x] **Honest sync indicator** — `trading_sync_state.last_checked_at` added (migration 004) and bumped on every poll. Trading page shows "newest trade Xm ago · checked Ys ago" so a quiet pool no longer looks broken. WS heartbeat shortened to 10s for snappier visual confirmation. 2026-05-27.

## Trading follow-ups (Phase 2 candidates)

- [ ] **STON.fi full integration** — trades + candles + WS, on parity with DeDust. Detection-only is what landed today.
- [x] **LP-aware concentration flags** — every top-N holder is now annotated with `is_lp` (from a live join against the detected pool set for that jetton) plus the existing user-managed `wallet.tags ∋ 'lp'` path. `concentrationFlags` skips LP holders and annotates the detail with `(LP excluded: N)`. UI renders an `LP (auto)` chip on the holder row. Unit tests in `tests/holders-lp.test.js`. *(Live regression case from the original note — "PUTIN's top-1 is the DeDust pool" — no longer reproduces; the PUTIN/TON pool isn't on DeDust right now.)*
- [ ] **TonAPI WebSocket option** — push-based trade source for sub-second updates, as an alternative to DeDust polling. Same `normalizeDedustTrade`-style parser, different ingest path. Useful for trade-alert Telegram bot in Phase 4.
- [ ] **USD price overlay** — DeDust REST doesn't expose USD. Cross-reference STON.fi's `lp_total_supply_usd` per pool to derive a TON→USD rate, render dollar values on the trading chart.
- [ ] **Mempool listener** — was Phase 3 in the original roadmap; deferred until DeDust polling proves too slow for the real-time use case it would unblock.

## Quality-of-life backlog

- [x] Lightweight test runner — `node:test` wired with `npm test`; 25 tests across detection / candles / stream
- [ ] More tests for `analyzers/*` pure functions and the new trade-parser
- [ ] OpenAPI schema for `/api/*` — generated, not handwritten
- [ ] Replace in-memory cache with SQLite-backed cache so restarts don't dump hot data
- [ ] Rate-limit middleware (token bucket per IP) — see `RATE_LIMIT_*` envs
- [ ] CORS policy (read-only GET from anywhere; everything else denied)
- [ ] Error envelope standard: `{ ok: false, error: { code, message } }`

## Won't-do (for now, deliberately deferred)

- ❌ User accounts, watchlists in DB — phase 4+
- ❌ Postgres — SQLite is fine until it isn't
- ❌ React / build pipeline — vanilla HTML is faster to iterate on
- ❌ Docker — PM2 + Node directly on the box is consistent with sibling projects
